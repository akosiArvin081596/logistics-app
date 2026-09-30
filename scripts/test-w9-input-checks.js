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
 * TEXT. The W-9 is filled in pdf-lib's standard Helvetica (the signature in
 * Helvetica Bold), whose characters are Latin. A legal name such as a Japanese
 * company name made the preview answer 500, and a submitted W-9 was never
 * produced. The legal name, business name, address and the W-9's signature
 * are now refused when that font cannot encode them: 400
 * { code: "UNSUPPORTED_CHARACTERS", field, error: "Please enter this as it
 * appears on your U.S. tax return, using Latin characters." } on apply, the W-9
 * preview, and POST /api/public/investor-w9-check, which /invest asks on step
 * 1 and before it takes a W-9 signature. Accented Latin the font can print
 * ("Café Ñandú LLC") passes. The two contracts, rendered by Chromium, are not
 * restricted.
 *
 * LENGTH. The font check walked the whole value, however long, and the fill
 * walked it again: one very long legal name held the server for seconds. The
 * legal name, business name and W-9 signature are now capped at 200
 * characters and the address at 300, checked by one comparison before any
 * character is looked at: 400 { code: "VALUE_TOO_LONG", field, error: "This is
 * too long. Please keep it to <cap> characters or fewer." } on all three
 * routes, so apply stores within the caps. The check route's body is parsed
 * with a 16 KB limit, mounted above the global 50 MB parser: 413
 * { code: "BODY_TOO_LARGE" }. /invest's three inputs carry the caps as
 * maxlength, and the page shows a VALUE_TOO_LONG where the value was typed.
 *
 * THE CAUSE. fillW9Form() reported every field that did not take its value as
 * "its AcroForm field names no longer match", which is what ops read in the
 * alert. A value longer than its boxes, and text the font cannot encode, now
 * say so; a real template mismatch keeps the old message.
 *
 * WHAT IS ASSERTED.
 *   §1 checkW9Tin() (lib/w9-input.js): the accepted and refused shapes, and the
 *      length cap before a bounded pattern.
 *   §2 the client's copy (client/src/lib/taxId.js) gives the same verdict and
 *      message on every row of §1's table.
 *   §3 checkW9Printable() / checkW9Text(): printable and unprintable text, and
 *      the answer IS the fill's font's: every code point of the Basic
 *      Multilingual Plane (and astral samples) gets the verdict pdf-lib's
 *      embedded Helvetica and Helvetica Bold give, and the shipped fillW9Form()
 *      renders exactly the examples the check passes. The length caps: at the
 *      cap passes, one over is VALUE_TOO_LONG naming the field, and a 10 MB
 *      value is refused without the font being asked about one character.
 *   §4 wiring: apply and the W-9 preview run the checks before anything is
 *      stored or rendered, and answer the 400s above; the preview checks only
 *      on the W-9; the check route, executed, answers them and nothing else.
 *      The check route's 16 KB parser, executed in a loopback Express app
 *      with the shipped global parser and JSON error handler: 413 for a large
 *      body (with or without a Content-Length), the global parser skips a body
 *      it already parsed, and other routes keep the 50 MB limit.
 *   §5 the cause, from the shipped fillW9Form() run with pdf-lib on the real
 *      template: a too-long TIN, text the font cannot encode on each line and
 *      in the signature, and a template field that is missing.
 *   §6 /invest (InvestorApplyView.vue): step 1's Continue and the W-9
 *      signature, lifted from the SFC and executed against the check route
 *      above, show the refusal where the value was typed and stop there.
 *   §7 MUTANTS, one per guard, each caught.
 *
 * Test TINs and QA-TEST names only. No app.db and no network: the only server
 * is §4's Express app, on an ephemeral 127.0.0.1 port, closed before exit.
 *
 * Run: node scripts/test-w9-input-checks.js    # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const { createRequire } = require("module");
const { pathToFileURL } = require("url");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");
const LIB_PATH = path.join(ROOT, "lib", "w9-input.js");
const LIB_SRC = fs.readFileSync(LIB_PATH, "utf8");
const CLIENT_PATH = path.join(ROOT, "client", "src", "lib", "taxId.js");
const CLIENT_SRC = fs.readFileSync(CLIENT_PATH, "utf8");
const VIEW_SRC = fs.readFileSync(path.join(ROOT, "client", "src", "views", "InvestorApplyView.vue"), "utf8");

let pass = 0;
const failures = [];
const ok = (cond, msg) => { if (cond) pass++; else failures.push(msg); };
function die(msg) { console.error(`FAILED: ${msg}`); process.exit(1); }
function section(title) { console.log(`\n${title}`); }
const cp = (...points) => String.fromCodePoint(...points);

let pdfLib;
let express;
try {
	pdfLib = require("pdf-lib");
	express = require("express");
} catch (e) {
	die(`a server dependency did not load (${e.message}); run npm ci under the .nvmrc Node`);
}
const imageLimits = require(path.join(ROOT, "lib", "image-size"));
const publicFormInput = require(path.join(ROOT, "lib", "public-form-input"));

// A (possibly mutated) copy of the lib, loaded without touching the real
// module, its requires resolved from lib/ as the real one's are.
const LIB_REQUIRE = createRequire(LIB_PATH);
function loadLib(src, req = LIB_REQUIRE) {
	const mod = { exports: {} };
	new Function("module", "exports", "require", src)(mod, mod.exports, req);
	return mod.exports;
}
// The lib with pdf-lib's font lookups counted: how many characters the font
// was asked about.
function countingLib(src = LIB_SRC) {
	let calls = 0;
	const counted = (font) => {
		const real = pdfLib.StandardFontEmbedder.for(font).encoding;
		return { encoding: { canEncodeUnicodeCodePoint: (cp) => { calls++; return real.canEncodeUnicodeCodePoint(cp); } } };
	};
	const req = (name) => (name === "pdf-lib" ? { ...pdfLib, StandardFontEmbedder: { for: counted } } : LIB_REQUIRE(name));
	return { lib: loadLib(src, req), calls: () => calls, reset: () => { calls = 0; } };
}
const LIB = loadLib(LIB_SRC);
// A (possibly mutated) copy of the client file: its exports become returns.
function loadClient(src) {
	const body = src.replace(/^export (const|function) /gm, "$1 ");
	const names = [...src.matchAll(/^export (?:const|function) ([A-Za-z_]\w*)/gm)].map((m) => m[1]);
	return new Function(`"use strict";\n${body}\nreturn { ${names.join(", ")} };`)();
}
const swap = (src, from, to) => { if (!src.includes(from)) die(`mutant anchor not found: ${from}`); return src.replace(from, to); };
const codeOnly = (s) => s.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
const failed = (rows) => rows.some((x) => !x.ok);
function rows() {
	const r = [];
	r.t = (cond, name) => { r.push({ ok: !!cond, name }); return !!cond; };
	return r;
}

// ===========================================================================
// §1 / §2 the TIN rule
// ===========================================================================
const TIN_MESSAGE = "Enter a 9-digit SSN or EIN.";
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
	const r = rows();
	for (const [label, value, accepted] of TIN_TABLE) {
		let v;
		try { v = verdictOf(check(value)); } catch (e) { v = { threw: e.message }; }
		const right = accepted ? v.ok === true : v.ok === false && v.message === TIN_MESSAGE;
		r.t(right, `${label}: ${accepted ? "accepted" : "refused with the message"} (got ${JSON.stringify(v)})`);
	}
	return r;
}
const serverVerdict = (x) => ({ ok: x.ok, message: x.message, code: x.code });
const clientVerdict = (x) => ({ ok: x.ok, message: x.message });

function tinSection(lib = LIB) {
	const r = tinRows(lib.checkW9Tin, serverVerdict);
	for (const [label, value, accepted] of TIN_TABLE) {
		let v;
		try { v = lib.checkW9Tin(value); } catch { v = {}; }
		if (accepted) r.t(v.value === value, `${label}: passed through unchanged, so it is stored and printed as before`);
		else r.t(v.code === "INVALID_TIN", `${label}: code INVALID_TIN`);
	}
	for (const absent of [undefined, null, ""]) {
		const v = lib.checkW9Tin(absent);
		r.t(v.ok === true && v.absent === true, `absent (${JSON.stringify(absent)}) passes as absent; required-ness is the caller's`);
	}
	const fn = codeOnly(LIB_SRC.slice(LIB_SRC.indexOf("function checkW9Tin("), LIB_SRC.indexOf("\n}\n", LIB_SRC.indexOf("function checkW9Tin("))));
	r.t(/raw\.length > TIN_MAX_LENGTH \|\| !TIN_CHARS_RE\.test\(raw\)/.test(fn), "the length cap is tested before the pattern (short-circuit order)");
	r.t(String(LIB.TIN_CHARS_RE) === "/^[0-9 -]{1,32}$/", "the pattern is one character class with a bounded quantifier");
	return r;
}

async function clientTinSection(src = CLIENT_SRC) {
	const client = loadClient(src);
	const r = tinRows(client.checkTin, clientVerdict);
	r.t(client.INVALID_TIN_MESSAGE === LIB.INVALID_TIN_MESSAGE, "the client and the server say the same words");
	r.t(client.TIN_MAX_LENGTH === LIB.TIN_MAX_LENGTH && String(client.TIN_CHARS_RE) === String(LIB.TIN_CHARS_RE),
		"the client and the server use the same length cap and pattern");
	r.t(client.checkTin("").ok === true && client.checkTin(undefined).ok === true, "the client lets an empty field be (required-ness is the form's)");
	if (src === CLIENT_SRC) {
		const real = await import(pathToFileURL(CLIENT_PATH).href);
		r.t(real.checkTin("12-34567890").ok === false && real.checkTin("12-3456789").ok === true,
			"the shipped ES module loads and agrees (the copy above is not a different file)");
	}
	return r;
}

// ===========================================================================
// §3 text the W-9's font can print
// ===========================================================================
const TEXT_MESSAGE = "Please enter this as it appears on your U.S. tax return, using Latin characters.";
const CAFE = `Caf${cp(0xe9)} ${cp(0xd1)}and${cp(0xfa)} LLC`;
const JP = cp(0x682a, 0x5f0f, 0x4f1a, 0x793e, 0x30c6, 0x30b9, 0x30c8);
const PRINTABLE = [
	["plain ASCII", "QA-TEST Holdings LLC"],
	["accented Latin (the brief's example)", CAFE],
	["punctuation", "QA-TEST O'Brien & Sons, Inc. #2 (Texas)"],
	["diaeresis and ring", `QA-TEST Zo${cp(0xeb)} ${cp(0xc5)}ngstr${cp(0xf6)}m`],
	["umlaut and sharp s", `QA-TEST M${cp(0xfc)}ller Stra${cp(0xdf)}e 5`],
	["ligature", `QA-TEST ${cp(0x152)}uvre`],
	["typographic apostrophe", `QA-TEST D${cp(0x2019)}Angelo Trucking`],
	["em dash", `QA-TEST${cp(0x2014)}Holdings`],
	["no-break space", `QA-TEST${cp(0xa0)}Holdings`],
];
const UNPRINTABLE = [
	["Japanese (the brief's example)", JP],
	["Chinese", cp(0x6d4b, 0x8bd5, 0x6709, 0x9650, 0x516c, 0x53f8)],
	["Cyrillic", `QA ${cp(0x41e, 0x41e, 0x41e, 0x20, 0x422, 0x435, 0x441, 0x442)}`],
	["Greek", cp(0x391, 0x3b8, 0x3ae, 0x3bd, 0x3b1)],
	["Arabic", cp(0x634, 0x631, 0x643, 0x629)],
	["Hebrew", cp(0x5d7, 0x5d1, 0x5e8, 0x5d4)],
	["an emoji (outside the BMP)", `QA-TEST ${cp(0x1f69a)}`],
	["a combining accent (decomposed)", `QA-TEST Cafe${cp(0x301)}`],
	["a zero-width space", `QA${cp(0x200b)}TEST`],
	["a lone surrogate", `QA-TEST ${String.fromCharCode(0xd800)}`],
	["a Latin letter the font lacks", `QA-TEST ${cp(0x141)}${cp(0xf3)}d${cp(0x17a)}`],
	["a tab", "QA\tTEST"],
	["a newline", "QA\nTEST"],
];

function printableRows(lib = LIB) {
	const r = rows();
	for (const font of ["field", "signature"]) {
		for (const [label, value] of PRINTABLE) {
			const v = lib.checkW9Printable([{ field: "f", value, font }]);
			r.t(v.ok === true, `${font} font, ${label}: printable (got ${JSON.stringify(v)})`);
		}
		for (const [label, value] of UNPRINTABLE) {
			const v = lib.checkW9Printable([{ field: "f", value, font }]);
			r.t(v.ok === false && v.code === "UNSUPPORTED_CHARACTERS" && v.field === "f" && v.message === TEXT_MESSAGE,
				`${font} font, ${label}: refused as UNSUPPORTED_CHARACTERS, naming the field (got ${JSON.stringify(v)})`);
		}
	}
	return r;
}

function textRows(lib = LIB) {
	const r = rows();
	r.t(lib.UNSUPPORTED_CHARACTERS_MESSAGE === TEXT_MESSAGE && lib.INVALID_TIN_MESSAGE === TIN_MESSAGE, "both messages are the agreed words, exactly");
	r.t(JSON.stringify(lib.W9_TEXT_FIELDS) === JSON.stringify(["legal_name", "dba", "address"]), "the step-1 fields are the legal name, business name and address, in that order");
	const body = { legal_name: CAFE, dba: "QA-TEST", address: `1 QA Test Way, Testville, TX 77001`, contact_person: JP, contact_title: JP, bankruptcy_liens: JP };
	r.t(lib.checkW9Text(body).ok === true, "fields the W-9 does not print (contact person, title, liens) are not checked");
	for (const field of ["legal_name", "dba", "address"]) {
		const v = lib.checkW9Text({ ...body, [field]: JP });
		r.t(v.ok === false && v.field === field, `${field} is checked, and named (got ${JSON.stringify(v)})`);
	}
	r.t(lib.checkW9Text({ legal_name: JP, dba: JP }).field === "legal_name", "the first failing field in form order is the one named");
	r.t(lib.checkW9Text({ ...body, signatureText: JP }).ok === true, "a signature is checked only when the caller names its field");
	const sig = lib.checkW9Text({ ...body, signatureText: JP }, { signature: "signatureText" });
	r.t(sig.ok === false && sig.field === "signatureText", "the named signature field is checked, and named");
	r.t(lib.checkW9Text({}).ok === true && lib.checkW9Text(undefined).ok === true && lib.checkW9Text(null).ok === true &&
		lib.checkW9Text({ legal_name: "", dba: null }).ok === true, "empty and absent values print nothing and pass");
	r.t(lib.checkW9Text({ address: 12345 }).ok === true, "a number is printed as its digits and passes");
	for (const [label, value] of [["a list", ["x"]], ["an object", { a: 1 }], ["true", true], ["NaN", NaN]]) {
		let v;
		try { v = lib.checkW9Text({ legal_name: value }); } catch (e) { v = { threw: e.message }; }
		r.t(v.ok === false && v.field === "legal_name", `${label} is refused, never thrown on (got ${JSON.stringify(v)})`);
	}
	let v;
	try { v = lib.checkW9Printable([{ field: "f", value: "QA", font: "__proto__" }]); } catch (e) { v = { threw: e.message }; }
	r.t(v.ok === false, "a font name that is not one of the two is refused, never thrown on");
	return r;
}

// The length caps, checked before any character is.
const TOO_LONG_MESSAGE = (max) => `This is too long. Please keep it to ${max} characters or fewer.`;
function lengthRows(src = LIB_SRC) {
	const r = rows();
	const { lib, calls, reset } = countingLib(src);
	r.t(JSON.stringify(lib.W9_TEXT_MAX_LENGTH) === JSON.stringify({ legal_name: 200, dba: 200, address: 300 }) && lib.W9_SIGNATURE_MAX_LENGTH === 200,
		"the caps: 200 for the legal name and business name, 300 for the address, 200 for the W-9 signature");
	const caps = [
		// [field, cap, font]
		["legal_name", 200, "field"], ["dba", 200, "field"], ["address", 300, "field"],
		["signatureText", 200, "signature"], ["signatures.w9.text", 200, "signature"], ["a field with no cap of its own", 200, "field"],
	];
	for (const [field, max, font] of caps) {
		const at = lib.checkW9Printable([{ field, value: `QA-TEST ${"q".repeat(max - 8)}`, font }]);
		const over = lib.checkW9Printable([{ field, value: `QA-TEST ${"q".repeat(max - 7)}`, font }]);
		r.t(at.ok === true, `${field}: ${max} characters pass (got ${JSON.stringify(at)})`);
		r.t(over.ok === false && over.code === "VALUE_TOO_LONG" && over.field === field && over.message === TOO_LONG_MESSAGE(max),
			`${field}: ${max + 1} characters are refused as VALUE_TOO_LONG, naming the field (got ${JSON.stringify(over)})`);
	}
	const body = { legal_name: "QA-TEST Holdings LLC", dba: "", address: "1 QA Test Way, Testville, TX 77001" };
	for (const [field, max] of [["legal_name", 200], ["dba", 200], ["address", 300]]) {
		const v = lib.checkW9Text({ ...body, [field]: "Q".repeat(max + 1) });
		r.t(v.ok === false && v.code === "VALUE_TOO_LONG" && v.field === field, `checkW9Text: a ${max + 1}-character ${field} is VALUE_TOO_LONG (got ${JSON.stringify(v)})`);
	}
	const sig = lib.checkW9Text({ ...body, signatureText: "Q".repeat(201) }, { signature: "signatureText" });
	r.t(sig.ok === false && sig.code === "VALUE_TOO_LONG" && sig.field === "signatureText", "checkW9Text: a 201-character W-9 signature is VALUE_TOO_LONG");
	const longJp = lib.checkW9Text({ legal_name: JP.repeat(40) });
	r.t(longJp.code === "VALUE_TOO_LONG", `the length is checked first: 280 characters the font cannot print are too long, not unsupported (got ${longJp.code})`);
	reset();
	const huge = lib.checkW9Printable([{ field: "legal_name", value: "Q".repeat(10 * 1024 * 1024) }]);
	r.t(huge.code === "VALUE_TOO_LONG" && calls() === 0, `a 10 MB legal name is refused without the font being asked about one character (asked ${calls()} times)`);
	reset();
	lib.checkW9Printable([{ field: "legal_name", value: "Q".repeat(200) }]);
	r.t(calls() === 200, `...while a value within the cap is asked about character by character (${calls()} of 200; the counter works)`);
	return r;
}

// The verdict for every code point of the BMP, and astral samples, against
// pdf-lib's own embedded fonts (the fill's encoder): no list of our own.
async function fontParityRows(lib = LIB) {
	const r = rows();
	const doc = await pdfLib.PDFDocument.create();
	const fonts = { field: await doc.embedFont(pdfLib.StandardFonts.Helvetica), signature: await doc.embedFont(pdfLib.StandardFonts.HelveticaBold) };
	const encodes = (font, s) => { try { font.encodeText(s); return true; } catch { return false; } };
	const points = [];
	for (let c = 0; c <= 0xffff; c++) points.push(c);
	points.push(0x10000, 0x1d400, 0x1f600, 0x1f69a, 0x10ffff);
	for (const font of ["field", "signature"]) {
		let disagree = 0;
		let printable = 0;
		for (const c of points) {
			const s = c > 0xffff ? String.fromCodePoint(c) : String.fromCharCode(c);
			const mine = lib.checkW9Printable([{ field: "f", value: s, font }]).ok;
			if (mine) printable++;
			if (mine !== encodes(fonts[font], s)) disagree++;
		}
		r.t(disagree === 0, `${font} font: the check and pdf-lib's embedded font agree on all ${points.length} code points (${disagree} disagree)`);
		r.t(printable > 150 && printable < 300, `${font} font: the printable set is the font's (${printable} code points), not everything or nothing`);
	}
	return r;
}

// ===========================================================================
// the shipped fillW9Form(), lifted out of server.js
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

// The check passes exactly what the shipped fill can print.
async function fillParityRows() {
	const r = rows();
	const fill = build();
	for (const [label, value] of [...PRINTABLE, ...UNPRINTABLE]) {
		for (const [as, over, verdict] of [
			["the name", { legalName: value }, LIB.checkW9Text({ legal_name: value }).ok],
			["the signature", { signatureText: value }, LIB.checkW9Printable([{ field: "s", value, font: "signature" }]).ok],
		]) {
			const renders = (await outcome(fill, over)).bytes > 1000;
			r.t(verdict === renders, `${label} as ${as}: the check ${verdict ? "passes" : "refuses"} it and the fill ${renders ? "renders" : "refuses"} it`);
		}
	}
	return r;
}

// ===========================================================================
// §4 wiring
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
function constList(name, src = SRC) {
	const m = src.match(new RegExp(`const ${name} = \\[([^\\]]*)\\];`));
	return m ? [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]) : null;
}
function callsFirst(src, call, later) {
	const at = src.indexOf(call);
	if (at < 0) return false;
	return later.every((n) => { const i = src.indexOf(n); return i < 0 || i > at; });
}
const TIN_REFUSAL = 'return res.status(400).json({ error: tinCheck.message, code: tinCheck.code, field: "ein_ssn" });';
const TEXT_REFUSAL = (v) => `return res.status(400).json({ error: ${v}.message, code: ${v}.code, field: ${v}.field });`;
const APPLY_LATER = ["resolveInviteToken(", "db.transaction(", "applyTx()", "buildInvestorDocRender(", "sendEmail("];

function applyTinWired(src) {
	const route = codeOnly(routeSource("post", "/api/public/investor-apply", src));
	const shape = route.indexOf("publicFormInput.checkPublicScalars(req.body, PUBLIC_INVESTOR_SCALAR_FIELDS)");
	const tin = route.indexOf("const tinCheck = w9Input.checkW9Tin(ein_ssn);");
	return shape >= 0 && tin > shape && callsFirst(route, "const tinCheck = w9Input.checkW9Tin(ein_ssn);", APPLY_LATER) &&
		route.includes(`if (!tinCheck.ok) {\n\t\t\t${TIN_REFUSAL}`);
}
function applyTextWired(src) {
	const route = codeOnly(routeSource("post", "/api/public/investor-apply", src));
	const shape = route.indexOf("publicFormInput.checkPublicScalars(req.body, PUBLIC_INVESTOR_SCALAR_FIELDS)");
	const text = route.indexOf("const w9Text = w9Input.checkW9Text(req.body);");
	return shape >= 0 && text > shape && callsFirst(route, "const w9Text = w9Input.checkW9Text(req.body);", APPLY_LATER) &&
		route.includes(`if (!w9Text.ok) {\n\t\t\t${TEXT_REFUSAL("w9Text")}`);
}
function applySignatureWired(src) {
	const route = codeOnly(routeSource("post", "/api/public/investor-apply", src));
	const call = 'const w9Signature = w9Input.checkW9Printable([{ field: "signatures.w9.text", value: signatures.w9.text, font: "signature" }]);';
	const loop = route.indexOf("consentByDoc[doc.key] = consent;");
	return loop >= 0 && route.indexOf(call) > loop &&
		callsFirst(route, call, ["signerNetworkEvidence(req)", ...APPLY_LATER.slice(1)]) &&
		route.includes(`if (!w9Signature.ok) {\n\t\t\t${TEXT_REFUSAL("w9Signature")}`);
}
function previewWired(src, what) {
	const route = codeOnly(routeSource("post", "/api/public/investor-preview-pdf/:docKey", src));
	const w9 = route.indexOf('if (docKey === "w9") {');
	const calls = {
		tin: ["const tinCheck = w9Input.checkW9Tin(ein_ssn);", `if (!tinCheck.ok) {\n\t\t\t\t${TIN_REFUSAL}`],
		text: ['const w9Text = w9Input.checkW9Text(req.body, { signature: "signatureText" });', `if (!w9Text.ok) {\n\t\t\t\t${TEXT_REFUSAL("w9Text")}`],
		shape: ["const w9Shape = publicFormInput.checkPublicScalars(req.body, PUBLIC_W9_PREVIEW_SCALAR_FIELDS);", "if (!w9Shape.ok) {"],
	}[what];
	const at = route.indexOf(calls[0]);
	return w9 >= 0 && at > w9 && at < route.indexOf("fillW9Form(") && route.includes(calls[1]) &&
		route.indexOf("w9Input.") > route.indexOf("renderPolicy(");
}

// POST /api/public/investor-w9-check, executed: its handler as registered.
const LIMITER = () => {};
function checkRoute(src = SRC) {
	const handlers = {};
	const app = { post: (p, ...h) => { handlers[p] = h; } };
	new Function("app", "investorTaxFormCheckLimiter", "publicFormInput", "w9Input", "PUBLIC_W9_CHECK_SCALAR_FIELDS",
		`"use strict";\n${routeSource("post", "/api/public/investor-w9-check", src)};`)(
		app, LIMITER, publicFormInput, LIB, constList("PUBLIC_W9_CHECK_SCALAR_FIELDS", src));
	return handlers["/api/public/investor-w9-check"];
}
function callRoute(handler, body) {
	const out = { status: 200, body: undefined };
	const res = { status(c) { out.status = c; return this; }, json(b) { out.body = b; return this; } };
	handler({ body }, res);
	return out;
}
const TEXT_400 = (field) => JSON.stringify({ error: TEXT_MESSAGE, code: "UNSUPPORTED_CHARACTERS", field });
const TOO_LONG_400 = (field, max) => JSON.stringify({ error: TOO_LONG_MESSAGE(max), code: "VALUE_TOO_LONG", field });

function checkRouteRows(src = SRC) {
	const r = rows();
	const mounted = checkRoute(src);
	if (!r.t(Array.isArray(mounted) && mounted.length === 2 && mounted[0] === LIMITER, "the check route is mounted behind its own limiter")) return r;
	const handler = mounted[1];
	const good = { legal_name: "QA-TEST Holdings LLC", dba: "", address: "1 QA Test Way, Testville, TX 77001" };
	const cases = [
		["step 1 in Latin", good, 200, JSON.stringify({ ok: true })],
		["the accented legal name", { ...good, legal_name: CAFE }, 200, JSON.stringify({ ok: true })],
		["a Latin W-9 signature", { signatureText: "QA-TEST Person" }, 200, JSON.stringify({ ok: true })],
		["nothing sent", {}, 200, JSON.stringify({ ok: true })],
		["no body", undefined, 200, JSON.stringify({ ok: true })],
		["a Japanese legal name", { ...good, legal_name: JP }, 400, TEXT_400("legal_name")],
		["a Japanese business name", { ...good, dba: JP }, 400, TEXT_400("dba")],
		["a Japanese street", { ...good, address: `${JP}, Testville, TX 77001` }, 400, TEXT_400("address")],
		["a Japanese W-9 signature", { signatureText: JP }, 400, TEXT_400("signatureText")],
		["a 300-character address", { ...good, address: `1 QA Test Way, ${"q".repeat(285)}` }, 200, JSON.stringify({ ok: true })],
		["a 201-character legal name", { ...good, legal_name: "Q".repeat(201) }, 400, TOO_LONG_400("legal_name", 200)],
		["a 201-character business name", { ...good, dba: "Q".repeat(201) }, 400, TOO_LONG_400("dba", 200)],
		["a 301-character address", { ...good, address: "Q".repeat(301) }, 400, TOO_LONG_400("address", 300)],
		["a 201-character W-9 signature", { signatureText: "Q".repeat(201) }, 400, TOO_LONG_400("signatureText", 200)],
	];
	for (const [label, body, status, json] of cases) {
		const got = callRoute(handler, body);
		r.t(got.status === status && JSON.stringify(got.body) === json, `${label}: ${status} ${json} (got ${got.status} ${JSON.stringify(got.body)})`);
	}
	const list = callRoute(handler, { legal_name: ["QA"] });
	r.t(list.status === 400 && list.body.code === "INVALID_FIELD" && list.body.field === "legal_name", "a list is refused as not one scalar (INVALID_FIELD)");
	const route = codeOnly(routeSource("post", "/api/public/investor-w9-check", src));
	r.t(!/\bdb\.|fillW9Form\(|renderPolicy\(|sendEmail\(|logAudit\(|notifyChange\(|\bio\./.test(route), "the check route stores, renders, sends and announces nothing");
	r.t(/const investorTaxFormCheckLimiter = rateLimit\(\{\n\twindowMs: 15 \* 60 \* 1000,\n\tmax: 60,/.test(src), "its limiter allows 60 per 15 minutes");
	return r;
}

// The check route's own body parser, executed: the shipped mount, the shipped
// global parser and the shipped JSON error handler, in server.js's order, in
// an Express app on an ephemeral loopback port.
const W9_CHECK_PARSER = 'app.use("/api/public/investor-w9-check", express.json({ limit: "16kb" }), (err, req, res, next) => {';
const GLOBAL_PARSER = 'app.use(express.json({ limit: "50mb" }));';
const JSON_ERROR_HANDLER = "// JSON payload too large error handler\napp.use((err, req, res, next) => {";
function post(port, route, text, { chunked = false } = {}) {
	return new Promise((resolve) => {
		const data = Buffer.from(text);
		const headers = { "Content-Type": "application/json" };
		if (!chunked) headers["Content-Length"] = data.length;
		const req = http.request({ host: "127.0.0.1", port, path: route, method: "POST", headers, timeout: 5000 }, (res) => {
			const chunks = [];
			res.on("data", (c) => chunks.push(c));
			res.on("end", () => {
				let json = null;
				try { json = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { json = null; }
				resolve({ status: res.statusCode, json });
			});
		});
		req.on("timeout", () => req.destroy(new Error("no answer in 5 s")));
		req.on("error", (e) => resolve({ status: 0, json: { error: e.message } }));
		for (let i = 0; i < data.length; i += 4096) req.write(data.subarray(i, i + 4096));
		req.end();
	});
}
async function bodyLimitRows(src = SRC) {
	const r = rows();
	const mountAt = src.indexOf(W9_CHECK_PARSER);
	const globalAt = src.indexOf(GLOBAL_PARSER);
	const handlerAt = src.indexOf(JSON_ERROR_HANDLER);
	if (!r.t(mountAt > 0 && globalAt > mountAt && handlerAt > globalAt,
		"the check route's 16 KB parser is mounted above the global 50 MB parser, and both above the JSON error handler")) return r;
	const mount = src.slice(mountAt, src.indexOf("\n});\n", mountAt) + 4);
	const errorHandler = src.slice(handlerAt, src.indexOf("\n});\n", handlerAt) + 4);
	const app = express();
	new Function("app", "express", `"use strict";\n${mount}\n${GLOBAL_PARSER}`)(app, express);
	app.post("/api/public/investor-w9-check", checkRoute(src)[1]);
	app.post("/api/other", (req, res) => res.json({ received: JSON.stringify(req.body).length }));
	new Function("app", `"use strict";\n${errorHandler}`)(app);
	const server = await new Promise((resolve) => { const s = app.listen(0, "127.0.0.1", () => resolve(s)); });
	const { port } = server.address();
	try {
		const large = JSON.stringify({ legal_name: "Q".repeat(20 * 1024) });
		const TOO_LARGE = JSON.stringify({ error: "Too much was sent to check. Please shorten what you entered and try again.", code: "BODY_TOO_LARGE" });
		for (const [label, chunked] of [["with a Content-Length", false], ["sent chunked, with none", true]]) {
			const x = await post(port, "/api/public/investor-w9-check", large, { chunked });
			r.t(x.status === 413 && JSON.stringify(x.json) === TOO_LARGE, `a 20 KB body ${label}: 413 BODY_TOO_LARGE (got ${x.status} ${JSON.stringify(x.json)})`);
		}
		const small = await post(port, "/api/public/investor-w9-check", JSON.stringify({ legal_name: "QA-TEST Holdings LLC", address: "1 QA Test Way, Testville, TX 77001" }));
		r.t(small.status === 200 && JSON.stringify(small.json) === JSON.stringify({ ok: true }),
			`a small body is parsed once and checked: 200 (the global parser skipped it; got ${small.status} ${JSON.stringify(small.json)})`);
		const long = await post(port, "/api/public/investor-w9-check", JSON.stringify({ legal_name: "Q".repeat(201) }));
		r.t(long.status === 400 && long.json && long.json.code === "VALUE_TOO_LONG", `a body within 16 KB with a value over its cap: 400 VALUE_TOO_LONG (got ${long.status})`);
		const broken = await post(port, "/api/public/investor-w9-check", "{\"legal_name\":");
		r.t(broken.status === 400 && broken.json && broken.json.error === "Invalid request. Please try again.", `malformed JSON goes on to the JSON error handler: 400 (got ${broken.status} ${JSON.stringify(broken.json)})`);
		const other = await post(port, "/api/other", JSON.stringify({ blob: "Q".repeat(100 * 1024) }));
		r.t(other.status === 200 && other.json && other.json.received > 100 * 1024, `another route still takes a 100 KB body (the 50 MB limit is unchanged; got ${other.status})`);
	} finally {
		await new Promise((resolve) => server.close(resolve));
	}
	return r;
}

function wiringRows(src = SRC) {
	const r = rows();
	r.t(/\nconst w9Input = require\("\.\/lib\/w9-input"\);\n/.test(src), "server.js loads lib/w9-input.js");
	r.t(applyTinWired(src), "apply: the TIN is checked after the scalar check and before the invite lookup, the transaction, the renders and the emails; 400 INVALID_TIN on field ein_ssn");
	r.t(applyTextWired(src), "apply: the name, business name and address are checked there too; 400 UNSUPPORTED_CHARACTERS naming the field");
	r.t(applySignatureWired(src), "apply: the W-9's signature (only the W-9's) is checked after the signature loop and before anything is written; 400 naming signatures.w9.text");
	r.t(previewWired(src, "shape") && previewWired(src, "tin") && previewWired(src, "text"),
		"W-9 preview: one scalar each, the TIN, then the text and signature, all before fillW9Form() and in the W-9 branch only (the Master Agreement and Lease renders are not restricted)");
	r.t(JSON.stringify(constList("PUBLIC_W9_PREVIEW_SCALAR_FIELDS", src)) === JSON.stringify(["legal_name", "dba", "address", "ein_ssn", "signatureText"]),
		"the preview's scalar list is exactly what the W-9 prints from its body");
	return r;
}

// ===========================================================================
// §5 the cause, from the shipped fillW9Form()
// ===========================================================================
async function causeRows(src = FILL_SRC, { stopEarly = false } = {}) {
	const r = rows();
	const t = (cond, name) => r.t(cond, name) || !stopEarly;
	const fill = build(src);
	const good = await outcome(fill, {});
	if (!t(good.bytes > 1000, `a nine-digit EIN renders (got ${JSON.stringify(good)})`)) return r;
	for (const [label, einSsn, entityType] of [["EIN, ten digits", "12-34567890", "LLC"], ["SSN, ten digits", "123-45-67890", "Sole Prop"], ["eleven bare digits", "12345678901", "LLC"]]) {
		const o = await outcome(fill, { einSsn, entityType });
		const right = o.code === "DOCUMENT_VALUE_TOO_LONG" && o.message.includes("Part I (TIN)") &&
			o.message.includes("longer than its boxes") && !o.message.includes(MISMATCH);
		if (!t(right, `${label}: recorded as too long for Part I, not as a template mismatch (got ${JSON.stringify(o)})`)) return r;
		t(!o.message.includes(einSsn.replace(/\D/g, "").slice(2)), `${label}: the message carries no digits of the TIN`);
	}
	const unprintable = [
		["the legal name", { legalName: JP }, "Line 1 (name)"],
		["the business name", { dba: JP }, "Line 2 (business name)"],
		["the street", { address: `${JP}, Testville, TX 77001` }, "Line 5 (address)"],
		["the city", { address: `1 QA Test Way, ${JP}` }, "Line 6 (city, state, ZIP)"],
		["the signature", { signatureText: JP }, "the signature"],
	];
	for (const [label, over, line] of unprintable) {
		const o = await outcome(fill, over);
		const right = o.code === "DOCUMENT_TEXT_UNPRINTABLE" && o.message.startsWith(`W-9 cannot print ${line}:`) &&
			o.message.includes("font") && !o.message.includes(MISMATCH);
		if (!t(right, `${label} in Japanese: recorded as text the font cannot encode, on ${line} (got ${JSON.stringify(o)})`)) return r;
		t(!/[^\x20-\x7e]/.test(o.message), `${label}: the message carries none of the text (ASCII only)`);
	}
	for (const [label, over] of [["legal name", { legalName: CAFE }], ["business name", { dba: CAFE }], ["address", { address: `${CAFE}, Testville, TX 77001` }], ["signature", { signatureText: CAFE }]]) {
		const o = await outcome(fill, over);
		t(o.bytes > 1000, `"${CAFE}" as the ${label} renders (got ${JSON.stringify(o)})`);
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
// §6 /invest, lifted from the SFC and executed
// ===========================================================================
function liftBlock(src, start, lastFn) {
	const a = src.indexOf(start);
	const f = src.indexOf(lastFn, a);
	if (a < 0 || f < 0) die(`view block not found: ${start} … ${lastFn}`);
	return src.slice(a, src.indexOf("\n}\n", f) + 2);
}
function liftFn(src, head) {
	const a = src.indexOf(head);
	if (a < 0) die(`view function not found: ${head}`);
	return src.slice(a, src.indexOf("\n}\n", a) + 2);
}
function viewCode(src) {
	return [
		liftBlock(src, "const W9_TEXT_FIELDS = [", "async function w9Refusal("),
		liftFn(src, "async function submitApplication("),
		liftFn(src, "async function handleSigned("),
	].join("\n");
}
// useApi's error shape (composables/useApi.js): message = data.error, and
// status, code and data.
function apiOver(handler, { fail } = {}) {
	const sent = [];
	const post = async (url, body) => {
		sent.push({ url, body });
		if (fail) throw fail;
		if (url !== "/api/public/investor-w9-check") throw new Error(`unexpected POST ${url}`);
		const out = callRoute(handler, body);
		if (out.status >= 400) {
			const err = new Error(out.body.error);
			err.status = out.status;
			err.code = out.body.code || "";
			err.data = out.body;
			throw err;
		}
		return out.body;
	};
	return { post, sent };
}
function buildView(src, api) {
	const ref = (v) => ({ value: v });
	const watchers = [];
	const watch = (getter, cb) => watchers.push({ getter, cb, last: getter() });
	const form = { legal_name: "QA-TEST Holdings LLC", dba: "", address: "1 QA Test Way, Testville, TX 77001", ein_ssn: "12-3456789" };
	const env = {
		form, api, ref, reactive: (o) => o, watch,
		step: ref(0), maxStep: ref(0), restoreNotice: ref(""),
		signatures: {}, selectedDoc: ref(null), documents: ref([]),
		previews: [],
	};
	env.fetchPreview = async (docKey, sig) => { env.previews.push({ docKey, sig }); };
	const names = ["form", "api", "ref", "reactive", "watch", "step", "maxStep", "restoreNotice", "signatures", "selectedDoc", "documents", "fetchPreview"];
	const fns = new Function(...names, `"use strict";\n${src}\nreturn { submitApplication, handleSigned, w9FieldErrors, signNotice };`)(...names.map((n) => env[n]));
	// Vue runs a watcher after each change; `set` does the same.
	const flush = () => { for (const w of watchers) { const v = w.getter(); if (v !== w.last) { w.last = v; w.cb(); } } };
	const set = (field, value) => { form[field] = value; flush(); };
	return { ...env, ...fns, set };
}
const SIGN = (docKey, text) => ({ docKey, text, image: "", consent: { agreed: true, text: "QA" } });

async function viewRows(src = viewCode(VIEW_SRC)) {
	const r = rows();
	const handler = checkRoute()[1];
	{
		const api = apiOver(handler);
		const v = buildView(src, api);
		v.set("legal_name", JP);
		await v.submitApplication();
		r.t(api.sent.length === 1 && api.sent[0].url === "/api/public/investor-w9-check" &&
			JSON.stringify(Object.keys(api.sent[0].body)) === JSON.stringify(["legal_name", "dba", "address"]),
		"Continue asks the check route with the three step-1 fields, and not the TIN");
		r.t(v.step.value === 0 && v.w9FieldErrors.legal_name === TEXT_MESSAGE, "a Japanese legal name: the message under Legal Name, and step 1 stays");
		v.set("legal_name", "QA-TEST Holdings LLC");
		r.t(v.w9FieldErrors.legal_name === undefined, "…the message goes once the legal name changes");
		await v.submitApplication();
		r.t(v.step.value === 1 && v.maxStep.value === 1, "…and Continue then moves on");
	}
	for (const field of ["dba", "address"]) {
		const v = buildView(src, apiOver(handler));
		v.set(field, `${JP}, Testville`);
		await v.submitApplication();
		r.t(v.step.value === 0 && v.w9FieldErrors[field] === TEXT_MESSAGE && Object.keys(v.w9FieldErrors).length === 1,
			`a Japanese ${field}: the message under that field only, and step 1 stays`);
	}
	{
		const v = buildView(src, apiOver(handler));
		v.set("legal_name", CAFE);
		await v.submitApplication();
		r.t(v.step.value === 1 && Object.keys(v.w9FieldErrors).length === 0, `"${CAFE}" moves on, with no message`);
	}
	const offline = new TypeError("Failed to fetch");
	const limited = Object.assign(new Error("Too many requests. Try again later."), { status: 429, code: "", data: {} });
	for (const [label, fail] of [["no answer", offline], ["the rate limit", limited]]) {
		const v = buildView(src, apiOver(handler, { fail }));
		v.set("legal_name", JP);
		await v.submitApplication();
		r.t(v.step.value === 1, `${label}: Continue moves on (the submission's own check still stands)`);
	}
	{
		const api = apiOver(handler);
		const v = buildView(src, api);
		await v.handleSigned(SIGN("w9", JP));
		r.t(v.signatures.w9 === undefined && v.signNotice.value === TEXT_MESSAGE && v.previews.length === 0,
			"a Japanese W-9 signature is not taken: the dialog says why and shows no signed preview");
		r.t(api.sent.length === 1 && JSON.stringify(api.sent[0].body) === JSON.stringify({ signatureText: JP }), "…asked of the check route as signatureText");
		await v.handleSigned(SIGN("w9", "QA-TEST Person"));
		r.t(v.signatures.w9 && v.signatures.w9.text === "QA-TEST Person" && v.signNotice.value === "" && v.previews.length === 1,
			"a Latin W-9 signature is taken, the notice cleared and the signed preview fetched");
	}
	{
		const v = buildView(src, apiOver(handler));
		await v.handleSigned(SIGN("w9", "Q".repeat(201)));
		r.t(v.signatures.w9 === undefined && v.signNotice.value === TOO_LONG_MESSAGE(200) && v.previews.length === 0,
			"a 201-character W-9 signature is not taken: the dialog says it is too long");
		v.set("address", "Q".repeat(301));
		await v.submitApplication();
		r.t(v.step.value === 0 && v.w9FieldErrors.address === TOO_LONG_MESSAGE(300),
			"a 301-character address (filled in, past the input's maxlength): the message under Principal Address, and step 1 stays");
	}
	{
		const api = apiOver(handler);
		const v = buildView(src, api);
		await v.handleSigned(SIGN("master_agreement", JP));
		await v.handleSigned(SIGN("vehicle_lease", JP));
		r.t(api.sent.length === 0 && v.signatures.master_agreement && v.signatures.vehicle_lease,
			"the two contracts' signatures are not restricted, nor asked about");
	}
	return r;
}

function viewTemplateRows() {
	const r = rows();
	for (const [field, id] of [["legal_name", "invest-legal-name-error"], ["dba", "invest-dba-error"], ["address", "invest-address-error"]]) {
		r.t(VIEW_SRC.includes(`:aria-invalid="w9FieldErrors.${field} ? 'true' : 'false'"`) &&
			VIEW_SRC.includes(`:aria-describedby="w9FieldErrors.${field} ? '${id}' : undefined"`) &&
			VIEW_SRC.includes(`<p v-if="w9FieldErrors.${field}" id="${id}" class="field-error" role="alert">{{ w9FieldErrors.${field} }}</p>`),
		`${field}: the input names its message, and the message renders under it`);
	}
	r.t(VIEW_SRC.includes(':notice="signNotice || termsNotice"'), "the sign dialog shows the W-9 signature's refusal");
	for (const field of ["legal_name", "dba", "address"]) {
		const at = VIEW_SRC.indexOf(`v-model="form.${field}"`);
		const tag = at < 0 ? "" : VIEW_SRC.slice(VIEW_SRC.lastIndexOf("<input", at), VIEW_SRC.indexOf("/>", at));
		const max = (tag.match(/\smaxlength="(\d+)"/) || [])[1];
		r.t(Number(max) === LIB.W9_TEXT_MAX_LENGTH[field], `${field}: the input's maxlength is the server's cap (${max} vs ${LIB.W9_TEXT_MAX_LENGTH[field]})`);
	}
	const copy = fs.readFileSync(path.join(ROOT, "docs", "investor-portal-copy.md"), "utf8");
	r.t(copy.includes(`\`${TIN_MESSAGE}\``) && copy.includes(`\`${TEXT_MESSAGE}\``) &&
		copy.includes(`\`${TOO_LONG_MESSAGE(200)}\``) && copy.includes(`\`${TOO_LONG_MESSAGE(300)}\``),
	"docs/investor-portal-copy.md lists every message word for word, for the client's sign-off");
	const submit = codeOnly(liftFn(VIEW_SRC, "async function submitOnboarding("));
	r.t(/const refusal = w9TextRefusal\(err\)\n\s*if \(refusal && W9_TEXT_FIELDS\.includes\(refusal\.field\)\) \{\n\s*w9FieldErrors\[refusal\.field\] = refusal\.message\n\s*showReviewModal\.value = false\n\s*step\.value = 0\n\s*return/.test(submit),
		"a submission refused for a step-1 field goes back to step 1 with the message under the field");
	r.t(/if \(refusal && refusal\.field === 'signatures\.w9\.text'\) \{\n\s*delete signatures\.w9\n\s*showReviewModal\.value = false\n\s*step\.value = 1/.test(submit),
		"a submission refused for the W-9 signature takes it back, on the documents step, to be signed again");
	return r;
}

// ===========================================================================
// §7 mutants
// ===========================================================================
async function mutantRows() {
	const r = rows();
	const lib = (from, to) => loadLib(swap(LIB_SRC, from, to));
	r.t(failed(tinSection(lib('if (raw.replace(/[ -]/g, "").length !== TIN_DIGITS) return tinRefusal();', ""))),
		"MUTANT the nine-digit count dropped (any length accepted, the old form): caught by §1");
	r.t(failed(tinSection(lib(" || !TIN_CHARS_RE.test(raw)", ""))),
		"MUTANT the character check dropped (letters and other separators accepted): caught by §1");
	r.t(failed(tinSection(lib('typeof raw !== "string" || ', ""))),
		"MUTANT the string check dropped (a number or list reaches the pattern): caught by §1");
	r.t(failed(await clientTinSection(swap(CLIENT_SRC, "const TIN_DIGITS = 9", "const TIN_DIGITS = 10"))),
		"MUTANT the client's copy drifts to ten digits: caught by §2");
	const noFont = lib("if (!embedder.encoding.canEncodeUnicodeCodePoint(ch.codePointAt(0))) return false;", "");
	r.t(failed(printableRows(noFont)) && failed(await fontParityRows(noFont)),
		"MUTANT the font is not asked (any text accepted, the old form): caught by §3");
	r.t(failed(textRows(lib('const W9_TEXT_FIELDS = ["legal_name", "dba", "address"];', 'const W9_TEXT_FIELDS = ["legal_name"];'))),
		"MUTANT the business name and address left unchecked: caught by §3");
	r.t(failed(lengthRows(swap(LIB_SRC, 'if (text !== null && text.length > max) return { ok: false, code: "VALUE_TOO_LONG", field, message: tooLongMessage(max) };', ""))),
		"MUTANT the length cap dropped (any length walked by the font, the old form): caught by §3");
	r.t(failed(await bodyLimitRows(swap(SRC, W9_CHECK_PARSER, W9_CHECK_PARSER.replace('limit: "16kb"', 'limit: "50mb"')))),
		"MUTANT the check route parsed with the 50 MB limit: caught by §4");
	const noApplyTin = swap(SRC, "const tinCheck = w9Input.checkW9Tin(ein_ssn);\n\t\tif (!tinCheck.ok) {", "const tinCheck = { ok: true };\n\t\tif (!tinCheck.ok) {");
	r.t(failed(wiringRows(noApplyTin)), "MUTANT the apply route's TIN check removed: caught by §4");
	const noPreviewTin = swap(SRC, "const tinCheck = w9Input.checkW9Tin(ein_ssn);\n\t\t\tif (!tinCheck.ok) {", "const tinCheck = { ok: true };\n\t\t\tif (!tinCheck.ok) {");
	r.t(failed(wiringRows(noPreviewTin)), "MUTANT the preview's TIN check removed: caught by §4");
	r.t(failed(wiringRows(swap(SRC, "const w9Text = w9Input.checkW9Text(req.body);", "const w9Text = { ok: true };"))),
		"MUTANT the apply route's text check removed: caught by §4");
	r.t(failed(wiringRows(swap(SRC, 'const w9Signature = w9Input.checkW9Printable([{ field: "signatures.w9.text", value: signatures.w9.text, font: "signature" }]);', "const w9Signature = { ok: true };"))),
		"MUTANT the apply route's W-9 signature check removed: caught by §4");
	const previewText = '\t\t\tconst w9Text = w9Input.checkW9Text(req.body, { signature: "signatureText" });\n\t\t\tif (!w9Text.ok) {\n\t\t\t\treturn';
	r.t(failed(wiringRows(swap(SRC, previewText, '\t\t\tconst w9Text = { ok: true };\n\t\t\tif (!w9Text.ok) {\n\t\t\t\treturn'))),
		"MUTANT the preview's text check removed: caught by §4");
	const checkText = '\tconst w9Text = w9Input.checkW9Text(req.body, { signature: "signatureText" });\n\tif (!w9Text.ok) {\n\t\treturn';
	r.t(failed(checkRouteRows(swap(SRC, checkText, "\tconst w9Text = { ok: true };\n\tif (!w9Text.ok) {\n\t\treturn"))),
		"MUTANT the check route answers 200 to everything: caught by §4");
	r.t(failed(await causeRows(swap(FILL_SRC, "if (max !== undefined && want.length > max) { overlongLines.push(line); return false; }", ""), { stopEarly: true })),
		"MUTANT a too-long value recorded as a template mismatch (the old cause): caught by §5");
	r.t(failed(await causeRows(swap(FILL_SRC, "if (!encodes(font, want)) { unprintableLines.push(line); return false; }", ""), { stopEarly: true })),
		"MUTANT text the font cannot encode recorded as a template mismatch (the old cause): caught by §5");
	r.t(failed(await causeRows(swap(FILL_SRC, 'if (!encodes(fontBold, signatureText)) throw unprintable(["the signature"]);', ""), { stopEarly: true })),
		"MUTANT an unprintable signature left to pdf-lib's own error: caught by §5");
	const view = viewCode(VIEW_SRC);
	r.t(failed(await viewRows(swap(view, "    w9FieldErrors[refusal.field] = refusal.message\n    return\n", "    w9FieldErrors[refusal.field] = refusal.message\n"))),
		"MUTANT step 1 shows the message but moves on anyway: caught by §6");
	r.t(failed(await viewRows(swap(view, "  if (docKey === 'w9') {", "  if (false) {"))),
		"MUTANT the W-9 signature taken unchecked: caught by §6");
	return r;
}

function record(r) {
	for (const x of r) ok(x.ok, x.name);
	console.log(`  ${r.filter((x) => x.ok).length}/${r.length} checks`);
}

(async () => {
	section("§1 checkW9Tin(): nine digits, hyphens and spaces only");
	record(tinSection());
	section("§2 the client's copy of the TIN rule says the same");
	record(await clientTinSection());
	section("§3 text the W-9's font can print, asked of the font");
	record(printableRows());
	record(textRows());
	record(lengthRows());
	record(await fontParityRows());
	record(await fillParityRows());
	section("§4 wiring: apply, the W-9 preview and the check route");
	record(wiringRows());
	record(checkRouteRows());
	record(await bodyLimitRows());
	section("§5 fillW9Form() records the cause");
	record(await causeRows());
	section("§6 /invest step 1 and the W-9 signature, executed");
	record(await viewRows());
	record(viewTemplateRows());
	section("§7 mutants");
	record(await mutantRows());
	if (failures.length) {
		console.error(`\nFAILURES (${failures.length}):`);
		for (const f of failures) console.error(`  ✗ ${f}`);
		console.error(`\n${pass} passed, ${failures.length} failed`);
		process.exit(1);
	}
	console.log(`\n✓ ${pass} assertions passed`);
})().catch((e) => { console.error(e); process.exit(1); });
