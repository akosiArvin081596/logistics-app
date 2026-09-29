#!/usr/bin/env node
/**
 * The investor W-9's line 3a follows the tax classification chosen on /invest.
 *
 * fillW9Form() used to check the LLC box and print "P" (partnership) for every
 * LLC, whatever the applicant chose. Per the W-9's line 3a instructions:
 *   - LLC taxed as a C corporation → the LLC box and "C";
 *   - LLC taxed as an S corporation → the LLC box and "S";
 *   - LLC taxed as a partnership → the LLC box and "P";
 *   - a single-member LLC that is disregarded (the form's "Individual/LLC") →
 *     its owner's box, Individual/sole proprietor, and NOT the LLC box;
 *   - no classification, or one not listed → the LLC box, letter left blank
 *     (the W-9 leaves the letter to the filer; it is not guessed).
 * Every other entity type, and every other field on the form, is unchanged.
 *
 * WHAT IS ASSERTED. The shipped fillW9Form() is lifted out of server.js and run
 * with pdf-lib on the real template (onboarding-templates/pdf/fw9.pdf). The one
 * thing stubbed is the form's flatten(), so the checkboxes and fields can be
 * read back from the saved PDF.
 *   §1 the mapping table, read back: which line 3a box is checked and the
 *      letter in the LLC field.
 *   §2 nothing else on the form moves with the classification: every other
 *      field's value is identical across classifications.
 *   §3 the four classifications /invest offers are exactly the four mapped,
 *      and both investor callers pass the stored / posted classification.
 *   §4 MUTANTS: the old fixed "P", and the disregarded LLC left on the LLC box.
 *
 * Pure: no server, no app.db, no network.
 *
 * Run: node scripts/test-w9-llc-classification.js    # exits 1 on failure
 */
"use strict";

const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const SRC = fs.readFileSync(path.join(ROOT, "server.js"), "utf8");

let pass = 0;
const failures = [];
const ok = (cond, msg) => { if (cond) pass++; else failures.push(msg); };
function die(msg) { console.error(`FAILED: ${msg}`); process.exit(1); }
function section(title) { console.log(`\n${title}`); }

let pdfLib;
try {
	pdfLib = require("pdf-lib");
} catch (e) {
	die(`a server dependency did not load (${e.message}); run npm ci under the .nvmrc Node`);
}
const imageLimits = require(path.join(ROOT, "lib", "image-size"));

function liftFunction(head) {
	const needle = `\n${head}`;
	const hits = SRC.split(needle).length - 1;
	if (hits !== 1) die(`expected exactly 1 definition starting ${JSON.stringify(head)}, found ${hits}`);
	const a = SRC.indexOf(needle) + 1;
	const end = SRC.indexOf("\n}\n", a);
	if (end < 0) die(`no column-0 "}" after ${head}`);
	return SRC.slice(a, end + 2);
}
const FILL_SRC = liftFunction("async function fillW9Form(");
const code = (s) => s.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");

// The real pdf-lib, except that the form's flatten() leaves the fields in
// place so they can be read back.
const PdfLibDocument = {
	load: async (bytes) => {
		const doc = await pdfLib.PDFDocument.load(bytes);
		doc.getForm().flatten = () => {};
		return doc;
	},
};
function build(src = FILL_SRC) {
	return new Function("path", "fs", "__dirname", "PdfLibDocument", "StandardFonts", "rgb", "imageLimits", "console",
		`"use strict";\n${src}\nreturn fillW9Form;`)(path, fs, ROOT, PdfLibDocument, pdfLib.StandardFonts, pdfLib.rgb, imageLimits,
		{ ...console, warn: () => {} });
}

const BOX = (i) => `topmostSubform[0].Page1[0].Boxes3a-b_ReadOrder[0].c1_1[${i}]`;
const LETTER = "topmostSubform[0].Page1[0].Boxes3a-b_ReadOrder[0].f1_03[0]";
const BOX_NAMES = ["Individual/sole proprietor", "C corporation", "S corporation", "Partnership", "Trust/estate", "LLC", "Other"];
const APPLICANT = { legalName: "QA Test Holdings LLC", dba: "QA Test", address: "1 QA Test Way, Testville, TX 77001", einSsn: "12-3456789", effectiveDate: "September 30, 2026" };

// Fills the form and reads line 3a (and every other field) back. pdf-lib warns
// on every getForm() of the IRS template that it drops the XFA copy; that
// notice is silenced here, as it says nothing about the fields.
async function fill(fillW9Form, entityType, taxClassification) {
	const warn = console.warn;
	console.warn = () => {};
	let bytes;
	let form;
	try {
		bytes = await fillW9Form({ ...APPLICANT, entityType, taxClassification });
		if (!bytes) die("the W-9 template was not found");
		form = (await pdfLib.PDFDocument.load(bytes)).getForm();
	} finally { console.warn = warn; }
	const checked = BOX_NAMES.map((_, i) => form.getCheckBox(BOX(i)).isChecked());
	const others = {};
	for (const f of form.getFields()) {
		const name = f.getName();
		if (name === LETTER || name.includes("c1_1[")) continue;
		if (f instanceof pdfLib.PDFTextField) others[name] = f.getText() || "";
		else if (f instanceof pdfLib.PDFCheckBox) others[name] = f.isChecked();
	}
	return { boxes: BOX_NAMES.filter((_, i) => checked[i]), letter: form.getTextField(LETTER).getText() || "", others };
}

const TABLE = [
	// [entity type, tax classification, boxes checked, letter]
	["LLC", "C-Corp", ["LLC"], "C"],
	["LLC", "S-Corp", ["LLC"], "S"],
	["LLC", "Partnership", ["LLC"], "P"],
	["LLC", "Individual/LLC", ["Individual/sole proprietor"], ""],
	["LLC", "", ["LLC"], ""],
	["LLC", undefined, ["LLC"], ""],
	["LLC", "Trust", ["LLC"], ""],
	["LLC", "c-corp", ["LLC"], ""],
	["LLC", "constructor", ["LLC"], ""],
	["LLC", 5, ["LLC"], ""],
	// Other entity types: unchanged.
	["Corp", "C-Corp", ["C corporation"], ""],
	["Corp", "S-Corp", ["C corporation"], ""],
	["Sole Prop", "Individual/LLC", ["Individual/sole proprietor"], ""],
	["Other", "", ["Other"], ""],
	["", "Partnership", [], ""],
];

async function tableSection(src = FILL_SRC) {
	const r = [];
	const t = (cond, name) => r.push({ ok: !!cond, name });
	const fillW9Form = build(src);
	for (const [entity, tax, boxes, letter] of TABLE) {
		const got = await fill(fillW9Form, entity, tax);
		t(JSON.stringify(got.boxes) === JSON.stringify(boxes) && got.letter === letter,
			`§1 ${JSON.stringify(entity)} + ${JSON.stringify(tax)}: box ${boxes.join(", ") || "(none)"}, letter "${letter}" (got box ${got.boxes.join(", ") || "(none)"}, letter "${got.letter}")`);
	}
	return r;
}

async function othersSection() {
	const r = [];
	const t = (cond, name) => r.push({ ok: !!cond, name });
	const fillW9Form = build();
	const base = await fill(fillW9Form, "LLC", "");
	t(base.others["topmostSubform[0].Page1[0].f1_01[0]"] === APPLICANT.legalName && base.others["topmostSubform[0].Page1[0].f1_14[0]"] === "12",
		"§2 the name and the EIN are on the form (the comparison below is not over an empty form)");
	for (const tax of ["C-Corp", "S-Corp", "Partnership", "Individual/LLC"]) {
		const got = await fill(fillW9Form, "LLC", tax);
		t(JSON.stringify(got.others) === JSON.stringify(base.others), `§2 LLC + ${tax}: every field outside line 3a is as with no classification`);
	}
	return r;
}

function sourceSection() {
	const r = [];
	const t = (cond, name) => r.push({ ok: !!cond, name });
	const view = fs.readFileSync(path.join(ROOT, "client", "src", "views", "InvestorApplyView.vue"), "utf8");
	const select = (view.match(/<select v-model="form\.tax_classification">([\s\S]*?)<\/select>/) || [])[1] || "";
	const options = [...select.matchAll(/<option(?: value="([^"]*)")?>([^<]*)<\/option>/g)].map(([, v, text]) => (v !== undefined ? v : text)).filter(Boolean);
	t(JSON.stringify(options.sort()) === JSON.stringify(["C-Corp", "Individual/LLC", "Partnership", "S-Corp"]),
		`§3 /invest offers exactly the four mapped classifications (got ${JSON.stringify(options)})`);
	const render = code(liftFunction("function buildInvestorDocRender("));
	t(/fillW9Form\(\{[\s\S]*?taxClassification: application\?\.tax_classification \|\| ""/.test(render),
		"§3 the signed W-9 (buildInvestorDocRender) passes the stored tax_classification");
	const previewAt = SRC.indexOf('app.post("/api/public/investor-preview-pdf/:docKey"');
	const preview = code(SRC.slice(previewAt, SRC.indexOf("\n});", previewAt)));
	t(/fillW9Form\(\{ \.\.\.appData, taxClassification: req\.body\.tax_classification \}\)/.test(preview),
		"§3 the /invest preview passes the posted tax_classification (the form sends it)");
	return r;
}

async function mutantSection() {
	const r = [];
	const t = (cond, name) => r.push({ ok: !!cond, name });
	const failed = (results) => results.some((x) => !x.ok);
	const swap = (src, from, to) => { if (!src.includes(from)) die(`mutant anchor not found: ${from}`); return src.replace(from, to); };
	t(failed(await tableSection(swap(FILL_SRC, 'llcLetter = llcTaxLetters.get(taxClassification) || "";', 'llcLetter = "P";'))),
		"MUTANT every LLC printed as \"P\" (the old form): caught by §1");
	t(failed(await tableSection(swap(FILL_SRC, 'if (taxClassification === "Individual/LLC") cbIdx = entityCheckMap["Sole Prop"];', 'if (taxClassification === "Individual/LLC") cbIdx = entityCheckMap.LLC;'))),
		"MUTANT a disregarded LLC left on the LLC box: caught by §1");
	return r;
}

function record(results) {
	for (const x of results) ok(x.ok, x.name);
	console.log(`  ${results.filter((x) => x.ok).length}/${results.length} checks`);
}

(async () => {
	section("§1 line 3a, read back from the filled template");
	record(await tableSection());
	section("§2 nothing else moves");
	record(await othersSection());
	section("§3 the classifications and the callers");
	record(sourceSection());
	section("§4 mutants");
	record(await mutantSection());
	if (failures.length) {
		console.error(`\nFAILURES (${failures.length}):`);
		for (const f of failures) console.error(`  ✗ ${f}`);
		console.error(`\n${pass} passed, ${failures.length} failed`);
		process.exit(1);
	}
	console.log(`\n✓ ${pass} assertions passed`);
})().catch((e) => { console.error(e); process.exit(1); });
